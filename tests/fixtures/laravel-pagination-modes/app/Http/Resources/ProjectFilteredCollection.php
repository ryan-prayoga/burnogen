<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectFilteredCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        return [
            'filtered' => collect($this->collection)
                ->map(fn ($project) => [
                    'id' => $project['id'],
                    'owner' => $project['owner_email'],
                    'label' => 'filtered-project',
                ])
                ->filter(fn ($project) => $project['owner'])
                ->values()
                ->all(),
        ];
    }
}
