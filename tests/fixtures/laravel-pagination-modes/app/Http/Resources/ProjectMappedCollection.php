<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectMappedCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        return [
            'results' => collect($this->collection)
                ->map(fn ($project) => [
                    'id' => $project['id'],
                    'owner' => $project['owner_email'],
                    'label' => 'mapped-project',
                ])
                ->values()
                ->all(),
        ];
    }
}
